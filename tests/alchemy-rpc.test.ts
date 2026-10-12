import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient } from "viem";
import { base } from "viem/chains";
import { alchemyRpcTransport, createRpcMetrics, requireAlchemyRpc } from "../server/alchemy-rpc";
const env = { ALCHEMY_API_KEY: "offline-test-key", NODE_ENV: "test" };

test("Alchemy financial scope requires a key and selects only its own chain endpoint", () => {
  assert.throws(() => requireAlchemyRpc(8453, {}), /Alchemy API key/);
  assert.equal(new URL(requireAlchemyRpc(8453, env)).hostname, "base-mainnet.g.alchemy.com");
  assert.equal(new URL(requireAlchemyRpc(4663, { ...env, ROBINHOOD_RPC_URL: "https://other.invalid" })).hostname, "robinhood-mainnet.g.alchemy.com");
});
test("transport counts every JSON-RPC method inside a batch and reuses its validated chain", async () => {
  const original = globalThis.fetch, metrics = createRpcMetrics(); let network = 0;
  globalThis.fetch = async (_url, init) => {
    const input = JSON.parse(String(init?.body)), rows = Array.isArray(input) ? input : [input]; network += rows.length;
    const results = rows.map(row => ({ jsonrpc: "2.0", id: row.id, result: row.method === "eth_chainId" ? "0x2105" : "0x1" }));
    return Response.json(Array.isArray(input) ? results : results[0]);
  };
  try {
    const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, env, { metrics }) });
    await Promise.all([client.getChainId(), client.getChainId()]);
    metrics.reset(); network = 0; await client.getChainId();
    assert.equal(network, 0); assert.equal(metrics.snapshot().calls, 0);
    await Promise.all([client.getBalance({ address: "0x1111111111111111111111111111111111111111" }), client.request({ method: "eth_call", params: [{ to: "0x1111111111111111111111111111111111111111" }, "latest"] })]);
    assert.equal(network, 2); assert.equal(metrics.snapshot().calls, 2); assert.equal(metrics.snapshot().cu, 46);
    assert.equal(metrics.snapshot().monthlyCuAtFiveMinutes, 397440);
  } finally { globalThis.fetch = original; }
});
test("429 backoff has jitter and a hard three-retry ceiling", async () => {
  const original = globalThis.fetch, waits: number[] = [], metrics = createRpcMetrics();
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, env, { metrics, random: () => .5, sleep: async ms => { waits.push(ms); } }) });
    await assert.rejects(() => client.getBlockNumber({ cacheTime: 0 }));
    assert.deepEqual(waits, [375, 625, 1125]); assert.equal(metrics.snapshot().calls, 4); assert.equal(metrics.snapshot().retries, 3);
  } finally { globalThis.fetch = original; }
});
test("unknown broadcast outcome never causes a transport resend", async () => {
  const original = globalThis.fetch, metrics = createRpcMetrics();
  globalThis.fetch = async () => new Response("rate limited", { status: 429 });
  try {
    const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, env, { metrics, sleep: async () => assert.fail("broadcast must not backoff-resend") }) });
    await assert.rejects(() => client.request({ method: "eth_sendRawTransaction", params: ["0x00"] }));
    assert.equal(metrics.snapshot().calls, 1);
  } finally { globalThis.fetch = original; }
});
test("wrong-chain response and a terminal failure invalidate the once-chain handshake", async () => {
  const original = globalThis.fetch; let fail = false, wrong = false, chains = 0;
  globalThis.fetch = async (_url, init) => {
    if (fail) return new Response("offline", { status: 503 });
    const input = JSON.parse(String(init?.body)), rows = Array.isArray(input) ? input : [input];
    const results = rows.map(row => { if (row.method === "eth_chainId") chains++; return { jsonrpc: "2.0", id: row.id, result: row.method === "eth_chainId" ? wrong ? "0x1237" : "0x2105" : "0x1" }; });
    return Response.json(Array.isArray(input) ? results : results[0]);
  };
  try {
    const client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, env) });
    await client.getChainId(); fail = true; await assert.rejects(() => client.getBlockNumber({ cacheTime: 0 }));
    fail = false; wrong = true; await assert.rejects(() => client.getChainId(), /financial scope/);
    wrong = false; await client.getChainId(); assert.equal(chains, 3);
  } finally { globalThis.fetch = original; }
});
test("free-tier log range is limited before any RPC is dispatched", async () => {
  const metrics = createRpcMetrics(), client = createPublicClient({ chain: base, transport: alchemyRpcTransport(8453, env, { metrics }) });
  await assert.rejects(() => client.getLogs({ fromBlock: 1n, toBlock: 11n }), /ten blocks/);
  assert.equal(metrics.snapshot().calls, 0);
});
