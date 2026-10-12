import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { base } from "viem/chains";
import { baseKeeperRpcTransport } from "../scripts/base-keeper-rpc";

type RpcCall = { method: string; params?: unknown[]; id: number; provider: "public" | "archive" };
const address = `0x${"11".repeat(20)}`, hash = (number = 16n) => `0x${number.toString(16).padStart(64, "0")}`;
const block = (number = "0x10", blockHash = hash(BigInt(number))) => ({ number, hash: blockHash });
let fixtureId = 0;
function fixture(t: TestContext, chainId: 8453 | 4663 = 8453, sameProvider = false) {
  const id = fixtureId++, publicUrl = `https://public-${id}.invalid/`, archiveUrl = sameProvider ? publicUrl : `https://archive-${id}.invalid/v2/archive-secret`;
  const calls: RpcCall[] = [];
  let response: ((call: RpcCall) => unknown | Promise<unknown>) | undefined;
  let failure: ((call: RpcCall) => number | undefined) | undefined;
  let rpcError: ((call: RpcCall) => { code: number; message: string; data?: unknown } | undefined) | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), rows = JSON.parse(String(init?.body)) as RpcCall | RpcCall[];
    const answers = await Promise.all((Array.isArray(rows) ? rows : [rows]).map(async row => {
      const call: RpcCall = { ...row, provider: url === publicUrl ? "public" : "archive" };
      calls.push(call);
      const status = failure?.(call);
      if (status) throw Object.assign(new Error(`secret ${archiveUrl}`), { status });
      const error = rpcError?.(call);
      if (error) return { jsonrpc: "2.0", id: row.id, error };
      let result = await response?.(call);
      if (result === undefined) result = call.method === "eth_chainId" ? `0x${chainId.toString(16)}`
        : call.method === "eth_getBlockByNumber" ? block(typeof call.params?.[0] === "string" && call.params[0].startsWith("0x") ? call.params[0] : "0x100")
        : call.method === "eth_getBlockByHash" ? block("0x10", String(call.params?.[0])) : "0xab";
      return { jsonrpc: "2.0", id: row.id, result };
    }));
    return Response.json(Array.isArray(rows) ? answers : answers[0]);
  });
  const environment = { ALCHEMY_API_KEY: "must-not-be-public-key", BASE_RPC_URL: publicUrl, ROBINHOOD_RPC_URL: publicUrl };
  const transport = baseKeeperRpcTransport(chainId, environment, archiveUrl)({ timeout: 99_000, retryCount: 9 });
  const request = (method: string, params?: unknown[]) => transport.request({ method, params } as any);
  return { calls, request, transport, publicUrl, archiveUrl, environment,
    respond(value: typeof response) { response = value; }, fail(value: typeof failure) { failure = value; },
    rpcFail(value: typeof rpcError) { rpcError = value; },
    count(provider: RpcCall["provider"], method: string) { return calls.filter(call => call.provider === provider && call.method === method).length; } };
}

for (const chainId of [8453, 4663] as const) {
  test(`host metadata routes public while all ${chainId} state stays archive`, async t => {
    const f = fixture(t, chainId);
    for (const method of ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs"])
      await f.request(method, method === "eth_getBlockByNumber" ? ["latest", false] : method === "eth_getLogs" ? [{}] : undefined);
    const state: [string, unknown[]][] = [
      ["eth_call", [{ to: address, data: "0x1234" }, "0x10"]], ["eth_getCode", [address, "0x10"]],
      ["eth_getBalance", [address, "0x10"]], ["eth_getTransactionCount", [address, "0x10"]],
      ["eth_getStorageAt", [address, "0x0", "0x10"]], ["eth_getProof", [address, ["0x0"], "0x10"]],
    ];
    for (const [method, params] of state) {
      await f.request(method, params);
      assert.deepEqual(f.calls.find(call => call.method === method && call.provider === "archive")?.params, params);
      assert.equal(f.count("public", method), 0);
    }
    assert.equal(f.count("public", "eth_getTransactionReceipt"), 1);
    assert.equal(f.count("archive", "eth_getTransactionReceipt"), 0);
    assert.equal(f.count(chainId === 8453 ? "archive" : "public", "eth_getLogs"), 1);
    assert.equal(f.count("public", "eth_getBlockByNumber"), 2, "one latest metadata read and one shared historical guard");
    assert.equal(f.count("archive", "eth_getBlockByNumber"), 1);
    assert.equal(f.transport.config.timeout, 15_000);
    assert.equal(f.transport.config.retryCount, 0);
  });
}

test("concurrent Base metadata dispatch remains below the public request limit", async t => {
  const f=fixture(t),times:number[]=[];
  f.respond(call=>{if(call.provider==="public")times.push(performance.now());return undefined;});
  await Promise.all(Array.from({length:10},(_,index)=>f.request("eth_getBlockByNumber",[`0x${(16+index).toString(16)}`,false])));
  assert.equal(times.length,11,"The shared network probe is also paced");
  assert(times.at(-1)!-times[0]>=550,"Ten metadata reads cannot burst past 25 requests per second");
  assert.equal(f.calls.some(call=>call.provider==="archive"),false);
});

test("current and default state use archive with no historical or public probes", async t => {
  const f = fixture(t);
  for (const selector of [undefined, "latest", "pending", "safe", "finalized"]) {
    const params = selector === undefined ? [address] : [address, selector];
    await f.request("eth_getCode", params);
    assert.deepEqual(f.calls.at(-1)?.params, params);
  }
  assert.equal(f.calls.some(call => call.provider === "public"), false);
  assert.equal(f.count("archive", "eth_chainId"), 1);
  assert.equal(f.count("archive", "eth_getBlockByNumber"), 0);
});

for (const provider of ["public", "archive"] as const) {
  test(`wrong ${provider} chain blocks historical state before it is read`, async t => {
    const f = fixture(t);
    f.respond(call => call.provider === provider && call.method === "eth_chainId" ? "0x1" : undefined);
    await assert.rejects(f.request("eth_call", [{ to: address }, "0x10"]), /provider chain mismatch/);
    assert.equal(f.count("archive", "eth_call"), 0);
  });
}

for (const condition of ["hash", "height", "missing"] as const) {
  test(`historical ${condition} disagreement stays pending without a state result`, async t => {
    const f = fixture(t);
    f.respond(call => call.provider === "archive" && call.method === "eth_getBlockByNumber"
      ? condition === "missing" ? null : condition === "height" ? block("0x11") : block("0x10", hash(99n)) : undefined);
    await assert.rejects(f.request("eth_getBalance", [address, "0x10"]), /provider block mismatch|canonical header unavailable/);
    assert.equal(f.count("archive", "eth_getBalance"), 0);
  });
}

test("numeric EIP-1898 and earliest selectors retain the exact state arguments", async t => {
  const f = fixture(t), selector = { blockNumber: "0x10" };
  await f.request("eth_getCode", [address, selector]);
  await f.request("eth_getCode", [address, "earliest"]);
  assert.deepEqual(f.calls.filter(call => call.method === "eth_getCode").map(call => call.params), [[address, selector], [address, "earliest"]]);
  assert(f.calls.some(call => call.method === "eth_getBlockByNumber" && call.params?.[0] === "0x0"));
});

test("canonical blockHash state binds both providers and preserves requireCanonical", async t => {
  const f = fixture(t), selector = { blockHash: hash(), requireCanonical: true };
  await f.request("eth_call", [{ to: address, data: "0x" }, selector]);
  assert.equal(f.count("public", "eth_getBlockByHash"), 1);
  assert.equal(f.count("archive", "eth_getBlockByHash"), 1);
  assert.equal(f.count("public", "eth_getBlockByNumber"), 1);
  assert.equal(f.count("archive", "eth_getBlockByNumber"), 1);
  assert.deepEqual(f.calls.find(call => call.method === "eth_call")?.params?.[1], selector);
});

test("canonical hash reorg is rejected while an explicit noncanonical hash retains its meaning", async t => {
  const f = fixture(t);
  f.respond(call => call.method === "eth_getBlockByNumber" ? block("0x10", hash(99n)) : undefined);
  await assert.rejects(f.request("eth_getCode", [address, { blockHash: hash(), requireCanonical: true }]), /noncanonical block hash/);
  assert.equal(f.count("archive", "eth_getCode"), 0);
  const selector = { blockHash: hash(), requireCanonical: false };
  await f.request("eth_getCode", [address, selector]);
  assert.deepEqual(f.calls.find(call => call.method === "eth_getCode")?.params?.[1], selector);
});

test("a blockHash response cannot substitute a different hash or height", async t => {
  const f = fixture(t);
  f.respond(call => call.method === "eth_getBlockByHash" && call.provider === "archive" ? block("0x11", hash()) : undefined);
  await assert.rejects(f.request("eth_getCode", [address, { blockHash: hash() }]), /provider block mismatch/);
  f.respond(call => call.method === "eth_getBlockByHash" ? block("0x10", hash(99n)) : undefined);
  await assert.rejects(f.request("eth_getCode", [address, { blockHash: hash() }]), /provider block mismatch/);
  assert.equal(f.count("archive", "eth_getCode"), 0);
});

test("parallel historical reads share chain and block guards, then recheck after TTL", async t => {
  const f = fixture(t); let now = 10_000;
  t.mock.method(Date, "now", () => now);
  await Promise.all(Array.from({ length: 40 }, () => f.request("eth_getBalance", [address, "0x10"])));
  for (const provider of ["public", "archive"] as const) {
    assert.equal(f.count(provider, "eth_chainId"), 1);
    assert.equal(f.count(provider, "eth_getBlockByNumber"), 1);
  }
  now += 15_001;
  f.respond(call => call.provider === "archive" && call.method === "eth_getBlockByNumber" ? block("0x10", hash(99n)) : undefined);
  await assert.rejects(f.request("eth_getBalance", [address, "0x10"]), /provider block mismatch/);
  assert.equal(f.count("archive", "eth_getBalance"), 40);
  assert.equal(f.count("archive", "eth_chainId"), 2);
});

test("failed chain and block guards are retryable instead of permanently cached", async t => {
  const f = fixture(t);
  f.respond(call => call.method === "eth_chainId" && call.provider === "archive" ? "0x1" : undefined);
  await assert.rejects(f.request("eth_getBalance", [address, "0x10"]), /provider chain mismatch/);
  f.respond(call => call.method === "eth_getBlockByNumber" && call.provider === "archive" ? block("0x10", hash(99n)) : undefined);
  await assert.rejects(f.request("eth_getBalance", [address, "0x10"]), /provider block mismatch/);
  f.respond(undefined);
  assert.equal(await f.request("eth_getBalance", [address, "0x10"]), "0xab");
  assert.equal(f.count("archive", "eth_chainId"), 2);
  assert.equal(f.count("archive", "eth_getBalance"), 1);
});

test("guard cache is bounded to 32 fixed blocks", async t => {
  const f = fixture(t);
  for (let number = 1; number <= 33; number++) await f.request("eth_getBalance", [address, `0x${number.toString(16)}`]);
  await f.request("eth_getBalance", [address, "0x1"]);
  assert.equal(f.count("public", "eth_getBlockByNumber"), 34, "the first guard was evicted");
  assert.equal(f.count("archive", "eth_getBlockByNumber"), 34);
});

test("public failures never fall back to archive or retry and do not expose RPC credentials", async t => {
  const f = fixture(t);
  await f.request("eth_chainId");
  f.fail(call => call.provider === "public" && call.method === "eth_getTransactionReceipt" ? 429 : undefined);
  await assert.rejects(f.request("eth_getTransactionReceipt", [hash()]), error => {
    assert.match((error as Error).message, /Host RPC pending.*HTTP 429/);
    let cursor = error as Error | undefined;
    const seen = new Set<Error>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor); assert.doesNotMatch(String(cursor), /https:|archive-secret|must-not-be-public-key/);
      cursor = cursor.cause as Error | undefined;
    }
    return true;
  });
  assert.equal(f.count("public", "eth_getTransactionReceipt"), 1);
  assert.equal(f.calls.some(call => call.provider === "archive"), false);
});

test("archive state failures stay pending without a public state fallback", async t => {
  const f = fixture(t);
  f.fail(call => call.provider === "archive" && call.method === "eth_call" ? 429 : undefined);
  await assert.rejects(f.request("eth_call", [{ to: address }, "latest"]), /archive eth_call request unavailable.*HTTP 429/);
  assert.equal(f.count("archive", "eth_call"), 1);
  assert.equal(f.count("public", "eth_call"), 0);
});

for (const [provider, method, params, code] of [
  ["public", "eth_getTransactionReceipt", [hash()], -32007],
  ["archive", "eth_call", [{ to: address, data: `0x${"99".repeat(16)}` }, "latest"], -1],
] as const) {
  test(`${provider} standard RPC error retains method/code/details without URLs, keys, or request data`, async t => {
    const f = fixture(t), requestData = `0x${"99".repeat(16)}`;
    f.rpcFail(call => call.provider === provider && call.method === method ? {
      code, message: `capacity unavailable ${f.publicUrl} ${f.archiveUrl} key=${f.environment.ALCHEMY_API_KEY}`,
      data: { params: [address, requestData], unsafeDetail: "do-not-copy-provider-data" },
    } : undefined);
    await assert.rejects(f.request(method, structuredClone(params) as unknown as unknown[]), error => {
      assert.match((error as Error).message, new RegExp(`${provider} ${method} request unavailable`));
      assert.match((error as Error).message, new RegExp(`RPC ${code}`));
      assert.match((error as Error).message, /capacity unavailable/);
      let cursor = error as Error | undefined;
      const seen = new Set<Error>();
      while (cursor && !seen.has(cursor)) {
        seen.add(cursor);
        assert.doesNotMatch(String(cursor), /https:|archive-secret|must-not-be-public-key|Request body|Request params|do-not-copy-provider-data/);
        assert.equal(String(cursor).includes(address), false);
        assert.equal(String(cursor).includes(requestData), false);
        cursor = cursor.cause as Error | undefined;
      }
      return true;
    });
    assert.equal(f.count(provider, method), 1, "diagnostic preservation adds no retry");
    assert.equal(f.count(provider === "public" ? "archive" : "public", method), 0, "diagnostic preservation adds no fallback");
  });
}

test("current state also requires the archive provider's correct chain", async t => {
  const f = fixture(t);
  f.respond(call => call.method === "eth_chainId" ? "0x1" : undefined);
  await assert.rejects(f.request("eth_call", [{ to: address }, "latest"]), /provider chain mismatch/);
  assert.equal(f.count("archive", "eth_call"), 0);
  assert.equal(f.calls.some(call => call.provider === "public"), false);
});

test("identical existing providers use one chain check and no extra block guards", async t => {
  const f = fixture(t, 8453, true);
  await f.request("eth_getCode", [address, "0x10"]);
  await f.request("eth_getBalance", [address, "0x10"]);
  assert.equal(f.count("public", "eth_chainId"), 1);
  assert.equal(f.count("public", "eth_getBlockByNumber"), 0);
  assert.equal(f.calls.some(call => call.provider === "archive"), false);
});

test("invalid endpoints and client chains fail locally without sending RPC", t => {
  const f = fixture(t, 4663);
  assert.throws(() => baseKeeperRpcTransport(4663, { ROBINHOOD_RPC_URL: "http://public.invalid" }, f.archiveUrl), /invalid HTTPS endpoint/);
  assert.throws(() => baseKeeperRpcTransport(4663, {}, "https://user:secret@archive.invalid"), /invalid HTTPS endpoint/);
  assert.throws(() => baseKeeperRpcTransport(4663, { ROBINHOOD_RPC_URL: f.publicUrl }, f.archiveUrl)({ chain: base }), /client chain mismatch/);
  assert.throws(() => baseKeeperRpcTransport(1 as any, {}, f.archiveUrl), /unsupported chain/);
  assert.equal(f.calls.length, 0);
});
