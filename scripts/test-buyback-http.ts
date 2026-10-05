import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { STOCKS } from "../src/lib/config";

const origin = "http://127.0.0.1:5188";
const checks: string[] = [];
const input = { stockAddress: STOCKS[0].address, amount: "0.01" };
const hash = `0x${"f".repeat(64)}`;
async function call(base: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json() };
}
function rejected(result: { status: number; body: any }, statuses: number[]) {
  assert(statuses.includes(result.status), `Expected rejection ${statuses.join("/")}, received ${result.status}`);
  assert.equal(typeof result.body.error, "string");
}

const config = await call(origin, "/api/config");
assert.equal(config.status, 200);
assert.equal(config.body.mode, "base");
assert.equal(config.body.chainId, 8453);
const before = await call(origin, "/api/buyback/batches");
assert.equal(before.status, 200);
assert(Array.isArray(before.body));
const idsBefore = before.body.map((batch: { id: string }) => batch.id).sort();
assert(!idsBefore.includes(hash), "Fixture ID must not refer to a real batch");

// The authorization field is rejected by the old, unsigned API's strict schema too.
// Require an authorization-specific error before probing its former shape,
// so this script can never create a sample batch on an outdated server.
const invalidAuthorization = await call(origin, "/api/buyback/batches", {
  ...input,
  authorization: {
    nonce: `0x${randomBytes(32).toString("hex")}`,
    expiresAt: Date.now() + 60_000,
    signature: `0x${"0".repeat(130)}`,
  },
});
rejected(invalidAuthorization, [400, 401, 403, 422]);
assert.match(invalidAuthorization.body.error, /授权|authorization/i,
  "Server must implement budget authorization before testing the old prepare shape");
const unauthorized = await call(origin, "/api/buyback/batches", { ...input, authorization: {} });
rejected(unauthorized, [400, 401, 403, 422]);
const legacyUnsigned = await call(origin, "/api/buyback/batches", input);
rejected(legacyUnsigned, [400, 401, 403, 422]);
checks.push("missing, invalid and legacy unsigned budget authorization rejected before batch creation");

for (const stockAddress of ["not-an-address", "0x1111111111111111111111111111111111111111"])
  rejected(await call(origin, "/api/buyback/quote", { ...input, stockAddress }), [400, 422]);
rejected(await call(origin, "/api/buyback/quote", { ...input, amount: "0.000000001" }), [400, 422]);
checks.push("invalid and non-whitelisted stocks and excessive amount precision rejected");

rejected(await call(origin, `/api/buyback/batches/${hash}/step?kind=unknown`), [400]);
rejected(await call(origin, `/api/buyback/batches/not-a-hash/step?kind=burn`), [400]);
rejected(await call(origin, `/api/buyback/batches/${hash}/track`, { kind: "unknown", hash }), [400]);
rejected(await call(origin, `/api/buyback/batches/${hash}/track`, { kind: "burn", hash: "not-a-hash" }), [400]);
rejected(await call(origin, `/api/buyback/batches/${hash}/track`, { kind: "burn", hash }), [404, 422]);
checks.push("invalid step kinds, malformed hashes and nonexistent batch tracking rejected");

for (const method of ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "eth_signTypedData_v4"]) {
  const result = await call(origin, "/api/rpc/robinhood", { jsonrpc: "2.0", id: 1, method, params: [] });
  assert.equal(result.status, 403);
  assert.equal(result.body.error.code, -32601);
}
checks.push("Robinhood RPC proxy rejects signing and transaction broadcasting");

const after = await call(origin, "/api/buyback/batches");
assert.equal(after.status, 200);
assert.deepEqual(after.body.map((batch: { id: string }) => batch.id).sort(), idsBefore,
  "Negative HTTP tests must not create mainnet batch records");
checks.push("batch IDs unchanged after all negative HTTP requests");

async function freePort() {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((done, fail) => probe.close((error) => error ? fail(error) : done()));
  return port;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => { clearTimeout(timer); done(); });
    child.kill("SIGTERM");
  });
}

const directory = await mkdtemp(join(tmpdir(), "musegod-buyback-http-"));
const rpc = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw);
  const answer = (item: any) => ({ jsonrpc: "2.0", id: item.id,
    ...(item.method === "eth_chainId" ? { result: "0x7a69" } : { error: { code: -32601, message: "HTTP gate fixture supports chain identity only" } }) });
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
});
let child: ChildProcess | undefined;
try {
  await new Promise<void>((done) => rpc.listen(0, "127.0.0.1", done));
  const port = await freePort();
  const forkOrigin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: resolve("."),
    env: { ...process.env, NODE_ENV: "production", PORT: String(port),
      CHAIN_MODE: "fork", DATA_DIR: directory,
      FORK_RPC_URL: `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`,
      PLATFORM_TREASURY: "0x1111111111111111111111111111111111111111",
      ENABLE_MAINNET_TRANSACTIONS: "false", ALCHEMY_API_KEY: "", COINGECKO_API_KEY: "",
      SUPABASE_URL: "", SUPABASE_SECRET_KEY: "", SUPABASE_DB_URL: "" },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("Isolated fork HTTP process exited before startup");
    try { ready = (await call(forkOrigin, "/api/config")).body.mode === "fork"; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert(ready, "Isolated fork HTTP process must start");
  for (const path of ["/api/buyback/stats", "/api/buyback/batches"]) {
    const result = await call(forkOrigin, path);
    rejected(result, [422]);
    assert.match(result.body.error, /分叉/);
  }
  const quote = await call(forkOrigin, "/api/buyback/quote", input);
  rejected(quote, [422]);
  assert.match(quote.body.error, /分叉/);
  const read = await call(forkOrigin, "/api/rpc/robinhood", { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  assert.equal(read.body.error.code, -32000);
  assert.match(read.body.error.message, /分叉/);
  checks.push("isolated fork-mode server rejects mainnet buyback statistics, quotes, batches and Robinhood RPC reads");
} finally {
  if (child) await stop(child);
  rpc.closeAllConnections();
  await new Promise<void>((done) => rpc.close(() => done()));
  await rm(directory, { recursive: true, force: true });
}

await writeFile("docs/evidence/buyback-http.json", JSON.stringify({
  observedAt: new Date().toISOString(),
  mainnetService: origin,
  scope: "HTTP rejection and read-only checks; no wallet signatures, broadcasts or sample mainnet batches",
  forkScope: "Separate actual Express fork-mode process with temporary SQLite and a chainId-only local RPC fixture; not EVM fork trade evidence",
  checks,
}, null, 2) + "\n");
console.log(`PASS: ${checks.length} buyback HTTP checks; no mainnet batch records created`);
