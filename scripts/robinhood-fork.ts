import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { robinhood } from "viem/chains";

// Only this loopback proxy sees the provider URL. Neither Anvil argv nor its
// nodeInfo/logs receive the API key. It cannot forward signatures or writes.
export async function startRobinhoodFork(upstreamUrl: string) {
  assert.equal(new URL(upstreamUrl).protocol, "https:");
  const upstream = createPublicClient({
    chain: robinhood,
    transport: http(upstreamUrl, { timeout: 40_000, retryCount: 0 }),
  });
  assert.equal(await upstream.getChainId(), 4663);
  const blockNumber = await upstream.getBlockNumber({ cacheTime: 0 });
  let blockedUpstreamWrites = 0;
  const proxy = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const part of request) {
        raw += part;
        if (raw.length > 1_000_000) throw new Error("RPC request too large");
      }
      const parsed = JSON.parse(raw);
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (!/^eth_get[A-Z]/.test(item.method) && ![
          "eth_call", "eth_blockNumber", "eth_chainId", "eth_gasPrice",
          "eth_feeHistory", "eth_maxPriorityFeePerGas", "net_version",
          "web3_clientVersion",
        ].includes(item.method)) {
          blockedUpstreamWrites++;
          throw new Error("Only reads may reach upstream");
        }
      }
      const result = await fetch(upstreamUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: raw,
        signal: AbortSignal.timeout(40_000),
      });
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(await result.text());
    } catch {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: -32000, message: "Read-only upstream unavailable" } }));
    }
  });
  const binary = resolve(process.env.ANVIL_BIN?.trim() || ".cache/bin/base-anvil-v1.1.1/anvil");
  await access(binary);
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const portProbe = createServer();
  await new Promise<void>((done) => portProbe.listen(0, "127.0.0.1", done));
  const forkPort = (portProbe.address() as AddressInfo).port;
  await new Promise<void>((done, fail) => portProbe.close((error) => error ? fail(error) : done()));
  const rpc = `http://127.0.0.1:${forkPort}`;
  const forkSource = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  let child: ChildProcess | undefined;
  let childOutput = "";
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
        child!.once("exit", () => { clearTimeout(timer); done(); });
        child!.kill("SIGTERM");
      });
    }
    proxy.closeAllConnections();
    await new Promise<void>((done) => proxy.close(() => done()));
  }
  async function rpcCall(method: string, params: unknown[] = []) {
    assert.equal(new URL(rpc).hostname, "127.0.0.1");
    const response = await fetch(rpc, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json();
    assert(!body.error, `Local fork ${method} failed: ${body.error?.message ?? ""}`);
    return body.result;
  }
  try {
    child = spawn(binary, [
      "--host", "127.0.0.1", "--port", String(forkPort), "--chain-id", "31337",
      "--fork-url", forkSource, "--fork-block-number", String(blockNumber),
      "--hardfork", "cancun", "--code-size-limit", "98304", "--silent",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (part) => {
      childOutput = (childOutput + String(part)).slice(-2000);
    });
    child.on("error", (error) => { childOutput = error.message; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Isolated Anvil exited: ${childOutput}`);
      try {
        assert.equal(await rpcCall("eth_chainId"), "0x7a69");
        assert.match(await rpcCall("web3_clientVersion"), /anvil/i);
        const info = await rpcCall("anvil_nodeInfo");
        assert.equal(info.forkConfig?.forkBlockNumber, Number(blockNumber));
        ready = true;
        break;
      } catch { await new Promise((done) => setTimeout(done, 200)); }
    }
    assert(ready, "Isolated Robinhood fork did not become ready");
    return { rpc, rpcCall, upstream, blockNumber, stop,
      blockedUpstreamWrites: () => blockedUpstreamWrites };
  } catch (error) { await stop(); throw error; }
}
