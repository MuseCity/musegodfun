import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { erc20Abi, getAddress, parseEther, toHex, type Hex } from "viem";
import { LaunchpadService } from "../server/service";
import { MusegodReader } from "../server/musegod";
import { runtimeFromEnv } from "../server/config";
import { Store } from "../server/store";
import { MUSEGOD, musegodSwapTransaction } from "../src/lib/musegod";
import { priceImpact } from "../src/lib/price-impact";
import { wrapAndSwapTransaction } from "../src/lib/protocol";
import { startChainFork } from "./robinhood-fork";
import { robinhoodUpstreamUrl, safeForkError } from "./nft-vault-fork-helpers";

// Only ALCHEMY_API_KEY is loaded by --env-file=.env.fork. All writes stay on isolated Anvil.
const key = process.env.ALCHEMY_API_KEY ?? "";
let upstreamUrl = "";
const evidencePath = ".superpowers/sdd/live-market/evidence/fork-price-impact.json";
const evidence: Record<string, any> = { status: "running", startedAt: new Date().toISOString(), mainnetWrites: false,
  runnerSha256: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"), cases: [] };
const upstreamMethods: Record<string, number> = {}, localMethods: Record<string, number> = {};
const nativeFetch = globalThis.fetch;
let localOrigin = "";
globalThis.fetch = async (input, init) => {
  const url = String(input), upstream = url === upstreamUrl;
  if ((upstream || localOrigin && url === localOrigin) && typeof init?.body === "string") {
    const parsed = JSON.parse(init.body);
    for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
      if (upstream) {
        assert.notEqual(call.method, "eth_getLogs");
        assert(!/send|sign|anvil_|evm_/.test(call.method), "No upstream writes");
      }
      const counts = upstream ? upstreamMethods : localMethods;
      counts[call.method] = (counts[call.method] ?? 0) + 1;
    }
  }
  return nativeFetch(input, init);
};
let fork: Awaited<ReturnType<typeof startChainFork>> | undefined, service: LaunchpadService | undefined;
const scratch = await mkdtemp(join(tmpdir(), "musegod-price-impact-"));
try {
  upstreamUrl = robinhoodUpstreamUrl(key);
  process.env.ANVIL_BIN = execFileSync("which", ["anvil"], { encoding: "utf8" }).trim();
  fork = await startChainFork(upstreamUrl, 4663, 31337); localOrigin = fork.rpc;
  const runtime = runtimeFromEnv(4663, { NODE_ENV: "test", CHAIN_MODE: "fork", FORK_CHAIN_ID: "4663", FORK_RPC_URL: fork.rpc,
    DATA_DIR: join(scratch, "store"), LIFI_INTEGRATOR: "musegodfun" });
  service = new LaunchpadService(runtime);
  const client = service.client, block = await client.getBlock({ blockNumber: fork.blockNumber });
  assert.equal(await client.getChainId(), 31337);
  assert.match(await fork.rpcCall("web3_clientVersion") as string, /anvil/i);
  evidence.fork = { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, chainId: 31337, deploymentChainId: 4663 };
  const coin = getAddress("0x7ea969d8c90c92c056949d561960af2accd6e113");
  // Copy the public record into an isolated local store. The real service still verifies its on-chain pool identity.
  const response = await nativeFetch(`https://musegod.fun/api/chains/4663/tokens/${coin}`, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok); const { token } = await response.json() as any;
  assert.equal(token.symbol, "CLAWGOD"); assert.equal(token.address.toLowerCase(), coin.toLowerCase());
  (service.store as Store).saveToken({ ...token, mode: "fork", deploymentChainId: 4663 });
  const reader = new MusegodReader(client, runtime.config, () => service!.assertNetwork());
  const account = getAddress("0x1000000000000000000000000000000000000017");
  assert.equal(await client.getCode({ address: account }), undefined);
  for (const symbol of ["CLAWGOD", "MUSEGOD"] as const) {
    const snapshot = await fork.rpcCall("evm_snapshot");
    const read = (amount: string) => symbol === "CLAWGOD" ? service!.quote(coin, "buy", amount, 100) : reader.quote("buy", amount, 100);
    const tiny = await read("0.000000001"), large = await read(symbol === "CLAWGOD" ? "1" : "10");
    const tinyImpact = priceImpact(tiny)!, largeImpact = priceImpact(large)!;
    assert(tinyImpact && largeImpact); assert.equal(tinyImpact.includesFees, false);
    assert(tinyImpact.percentMicros >= -50_000n && tinyImpact.percentMicros <= 50_000n, "Tiny fee-excluded impact within 0.05 percentage points of zero");
    assert(largeImpact.percentMicros > tinyImpact.percentMicros, "Impact grows with size");
    await fork.rpcCall("anvil_setBalance", [account, toHex(parseEther("100"))]);
    await fork.rpcCall("anvil_impersonateAccount", [account]);
    const target = symbol === "CLAWGOD" ? coin : MUSEGOD.token;
    const balance = () => client.readContract({ address: target, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    const before = await balance();
    const tx = symbol === "CLAWGOD" ? wrapAndSwapTransaction((large as any).poolKey, MUSEGOD.weth,
      BigInt(large.amountIn), BigInt(large.amountOut), large.slippageBps, BigInt(Math.floor(large.expiresAt / 1000)))
      : musegodSwapTransaction(large as any, account, runtime.config);
    const hash = await fork.rpcCall("eth_sendTransaction", [{ from: account, to: tx.to, data: tx.data, value: toHex(tx.value), gas: toHex(3_000_000n) }]) as Hex;
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 100 });
    assert.equal(receipt.status, "success"); const received = await balance() - before;
    assert.equal(received, BigInt(large.amountOut), "Fork output exactly equals real server quote");
    evidence.cases.push({ symbol, tiny: { quote: tiny, impact: tinyImpact }, large: { quote: large, impact: largeImpact },
      execution: { hash, status: receipt.status, received, quoted: large.amountOut, exactMatch: true } });
    assert.equal(await fork.rpcCall("evm_revert", [snapshot]), true);
  }
  evidence.status = "passed";
} catch (error) { evidence.status = "blocked"; evidence.error = safeForkError(error, [key]); process.exitCode = 1; }
finally {
  try { (service?.store as Store | undefined)?.close(); } finally {
    if (fork) {
      evidence.blockedUpstreamWrites = fork.blockedUpstreamWrites();
      const port = Number(new URL(fork.rpc).port); await fork.stop();
      const probe = createServer(); await new Promise<void>((done, fail) => probe.once("error", fail).listen(port, "127.0.0.1", done));
      await new Promise<void>((done, fail) => probe.close(error => error ? fail(error) : done())); evidence.anvilPortFree = true;
    }
    globalThis.fetch = nativeFetch; await rm(scratch, { recursive: true, force: true });
    await unlink(".env.fork").catch(error => { if (error.code !== "ENOENT") throw error; }); evidence.forkEnvDeleted = true;
  }
  evidence.upstreamMethods = upstreamMethods; evidence.upstreamRpcCount = Object.values(upstreamMethods).reduce((a, b) => a + b, 0);
  evidence.localMethods = localMethods; evidence.completedAt = new Date().toISOString();
  const text = JSON.stringify(evidence, (_key, value) => typeof value === "bigint" ? String(value) : value, 2) + "\n";
  assert(!key || !text.includes(key)); await mkdir(evidencePath.slice(0, evidencePath.lastIndexOf("/")), { recursive: true });
  await writeFile(evidencePath, text); console.log(JSON.stringify({ status: evidence.status, error: evidence.error, evidence: evidencePath }));
}
