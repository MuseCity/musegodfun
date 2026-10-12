import { http, type Transport } from "viem";
import { mainnetRpcUrl, type RuntimeEnvironment, type DeploymentChainId } from "./config";

// Alchemy's published standard JSON-RPC CU schedule, checked 2026-10-12.
// Each method inside an HTTP batch is billed individually; multicall is eth_call.
export const ALCHEMY_METHOD_CU: Readonly<Record<string, number>> = {
  eth_chainId: 0, eth_blockNumber: 10, eth_maxPriorityFeePerGas: 10, eth_feeHistory: 10,
  eth_call: 26, eth_getLogs: 60, eth_sendRawTransaction: 40, eth_simulateV1: 40,
  eth_getBalance: 20, eth_getBlockByNumber: 20, eth_getBlockByHash: 20, eth_getCode: 20,
  eth_getStorageAt: 20, eth_getTransactionCount: 20, eth_getTransactionByHash: 20,
  eth_getTransactionReceipt: 20, eth_estimateGas: 20, eth_gasPrice: 20,
};
export function createRpcMetrics() {
  let methods: Record<string, { calls: number; cu: number }> = {}, retries = 0;
  return {
    record(method: string, retry: boolean) {
      const row = methods[method] ??= { calls: 0, cu: 0 };
      row.calls++; row.cu += ALCHEMY_METHOD_CU[method] ?? 100; if (retry) retries++;
    },
    reset() { methods = {}; retries = 0; },
    snapshot() {
      const byMethod = structuredClone(methods), calls = Object.values(methods).reduce((n, row) => n + row.calls, 0);
      const cu = Object.values(methods).reduce((n, row) => n + row.cu, 0);
      return { calls, cu, retries, byMethod, monthlyCuAtFiveMinutes: cu * 12 * 24 * 30 };
    },
  };
}
export type RpcMetrics = ReturnType<typeof createRpcMetrics>;
export function requireAlchemyRpc(chainId: DeploymentChainId, environment: RuntimeEnvironment): string {
  if (!environment.ALCHEMY_API_KEY?.trim()) throw new Error("Alchemy API key is required for mainnet operation");
  const url = new URL(mainnetRpcUrl(chainId, environment));
  if (url.protocol !== "https:" || !url.hostname.endsWith(".g.alchemy.com") ||
    url.hostname !== `${chainId === 8453 ? "base-mainnet" : "robinhood-mainnet"}.g.alchemy.com`)
    throw new Error("Mainnet operation requires the chain-scoped Alchemy RPC");
  return url.href;
}
function limited(error: unknown): boolean {
  const seen = new Set<unknown>(); let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current); const e = current as { status?: number; code?: number; cause?: unknown; message?: string };
    if (e.status === 429 || e.code === 429 || /(?:\b429\b|rate limit|too many requests)/i.test(e.message ?? "")) return true;
    current = e.cause;
  }
  return false;
}
/** No alternate provider, trace, archive split or unbounded retry. The chain
 * handshake is cached per transport and invalidated by a terminal RPC error. */
export function alchemyRpcTransport(chainId: DeploymentChainId, environment: RuntimeEnvironment,
  options: { metrics?: RpcMetrics; timeout?: number; maxRetries?: number; random?: () => number;
    sleep?: (ms: number) => Promise<void> } = {}): Transport {
  const url = requireAlchemyRpc(chainId, environment), retries = options.maxRetries ?? 3;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) throw new Error("Alchemy retry ceiling is at most three");
  const base = http(url, { batch: { batchSize: 20, wait: 0 }, timeout: options.timeout ?? 15000, retryCount: 0,
    fetchFn: fetch.bind(globalThis) });
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), random = options.random ?? Math.random;
  return parameters => {
    const transport = base(parameters); let chain: Promise<unknown> | undefined;
    async function request(args: { method: string; params?: unknown }, requestOptions?: unknown) {
      if (args.method === "eth_getLogs") {
        const filter = Array.isArray(args.params) ? args.params[0] as { fromBlock?: string; toBlock?: string } : undefined;
        if (filter?.fromBlock && filter.toBlock && /^0x[\da-f]+$/i.test(filter.fromBlock) && /^0x[\da-f]+$/i.test(filter.toBlock) &&
          BigInt(filter.toBlock) - BigInt(filter.fromBlock) > 9n) throw new Error("Alchemy free-tier logs require at most ten blocks");
      }
      for (let attempt = 0;; attempt++) {
        options.metrics?.record(args.method, attempt > 0);
        try { return await transport.request(args as any, requestOptions as any); }
        catch (error) {
          if (!limited(error) || attempt >= retries || args.method === "eth_sendRawTransaction") { chain = undefined; throw error; }
          await sleep(Math.floor(250 * 2 ** attempt + Math.max(0, Math.min(1, random())) * 250));
        }
      }
    }
    return { ...transport, request: ((args: { method: string; params?: unknown }, requestOptions?: unknown) => {
      if (args.method !== "eth_chainId") return request(args, requestOptions);
      return chain ??= request(args, requestOptions).then(value => {
        if (typeof value !== "string" || BigInt(value) !== BigInt(chainId)) { chain = undefined; throw new Error("Alchemy RPC chain differs from its financial scope"); }
        return value;
      }).catch(error => { chain = undefined; throw error; });
    }) as typeof transport.request };
  };
}
